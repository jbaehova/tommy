import { resolveLocale, translateFor } from "@tommy/i18n";

/** No external script runs in a form that receives a password. The WebView supplies launch data in the fragment. */
export function telegramMiniAppPage(nonce: string, language: string): string {
  const locale = resolveLocale("system", language);
  const t = translateFor(locale);
  const text = JSON.stringify({
    agents: t("sidebar.view.agents"),
    empty: t("sidebar.empty.noAgents"),
    retry: t("browser.telegram.refresh"),
    mcpConnect: t("status.messaging.telegramMcpConnect"),
    mcpOpen: t("browser.telegram.mcpOpen"),
    mcpReturn: t("browser.telegram.mcpReturn"),
    skip: t("browser.telegram.skip"),
    promptTitle: t("browser.telegram.promptTitle"),
    vaultTitle: t("browser.telegram.vaultTitle"),
    apiKeyTitle: t("browser.telegram.apiKeyTitle"),
    reopen: t("browser.telegram.openFromManager"),
    ready: t("browser.telegram.ready"),
    viewSnapshot: t("browser.telegram.viewSnapshot"),
    refreshSnapshot: t("browser.telegram.refreshSnapshot"),
    snapshotUnavailable: t("browser.telegram.snapshotUnavailable"),
    pending: t("browser.telegram.pending"),
    password: t("browser.secret.title.password"),
    passwordField: t("browser.secret.password"),
    submitting: t("browser.secret.submitting"),
    username: t("browser.secret.username"),
    authenticator: t("browser.secret.title.authenticator"),
    otp: t("browser.secret.title.code"),
    codeField: t("browser.secret.codeLength", { digits: "{digits}" }),
    privacy: t("browser.secret.notAddedToChat"),
    confirm: t("browser.secret.submit"),
    cancel: t("common.cancel"),
    failure: t("browser.secret.failed"),
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Tommy</title>
<style nonce="${nonce}">
:root{
  --bg:#ffffff;--fg:#0a0a0a;--muted:#6b6b6b;--subtle:#fafafa;--border:#eaeaea;--border-strong:#d4d4d4;
  --solid:#0a0a0a;--on-solid:#ffffff;--ring:rgba(10,10,10,.12);--ok:#16a34a;--wait:#d97706;--bad:#e5484d;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 1px 1px rgba(0,0,0,.02);--skeleton:#f2f2f2;
  --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
:root[data-theme=dark]{
  --bg:#0a0a0a;--fg:#ededed;--muted:#a1a1a1;--subtle:#111111;--border:#262626;--border-strong:#3a3a3a;
  --solid:#ededed;--on-solid:#0a0a0a;--ring:rgba(237,237,237,.16);--ok:#22c55e;--wait:#f59e0b;--bad:#ff6369;
  --shadow:none;--skeleton:#1a1a1a;color-scheme:dark;
}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:max(12px,env(safe-area-inset-top)) 16px 12px;background:color-mix(in srgb,var(--bg) 82%,transparent);
  -webkit-backdrop-filter:saturate(180%) blur(12px);backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;letter-spacing:-.01em}
.mark{width:22px;height:22px;border-radius:6px;background:var(--solid);display:grid;place-items:center}
.mark::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--on-solid)}
main{max-width:560px;margin:0 auto;padding:20px 16px max(32px,env(safe-area-inset-bottom))}
.label{margin:4px 2px 10px;font-size:12px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.card{background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:16px;margin-bottom:12px}
.head{display:flex;align-items:center;gap:12px;min-width:0}
.avatar{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:600;font-size:14px}
.who{flex:1;min-width:0}
.name{font-weight:600;font-size:15px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.handle{display:block;color:var(--muted);font-size:13px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.handle:active{color:var(--fg)}
.badge{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid var(--border);
  border-radius:999px;font-size:12px;font-weight:500;color:var(--muted);background:var(--subtle)}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--wait)}
.badge.ok::before{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}
.block{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.row .origin{flex:0 1 auto;min-width:0}.row button{flex:none;white-space:nowrap}
.title{margin:0 0 8px;font-weight:600;font-size:14px}
.origin{display:inline-block;max-width:100%;font:12px/1.4 var(--mono);padding:3px 8px;border:1px solid var(--border);
  border-radius:6px;background:var(--subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.note{margin:8px 0 0;font-size:12px;color:var(--muted)}
label{display:block;margin-top:12px;font-size:13px;font-weight:500}
input{display:block;width:100%;height:40px;margin-top:6px;padding:0 12px;font:15px var(--sans);color:var(--fg);background:var(--bg);
  border:1px solid var(--border-strong);border-radius:8px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--fg);box-shadow:0 0 0 3px var(--ring)}
input[inputmode=numeric]{font-family:var(--mono);letter-spacing:.3em}
button{font:500 14px var(--sans);height:40px;padding:0 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-strong);
  background:var(--bg);color:var(--fg);transition:background .15s,opacity .15s;-webkit-tap-highlight-color:transparent}
button:active{background:var(--subtle)}
button.primary{background:var(--solid);color:var(--on-solid);border-color:var(--solid)}
button.primary:active{opacity:.85}
button.small{height:32px;padding:0 12px;font-size:13px}
button:disabled{opacity:.5;cursor:default}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}
.icon{width:32px;height:32px;padding:0;display:grid;place-items:center;border-color:var(--border)}
.icon svg{width:16px;height:16px}
.icon:disabled svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.shot{margin:12px 0 0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--subtle)}
.shot img{display:block;width:100%;height:auto}
.shot[hidden],img[hidden]{display:none}
.shot.loading{aspect-ratio:16/10}
.shimmer,.shot.loading{background:linear-gradient(90deg,var(--skeleton) 0,var(--subtle) 50%,var(--skeleton) 100%);background-size:200% 100%;animation:shimmer 1.2s ease-in-out infinite}
@keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.ghost{height:96px;border-radius:12px;margin-bottom:12px}
.question{margin-top:14px}.question>label{margin-top:0}
.kind-label{display:block;margin-bottom:4px;font-size:12px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.ask{margin:0 0 8px;font-size:13px;font-weight:500}
.choices{display:grid;gap:8px}
.choice{display:flex;align-items:flex-start;gap:10px;margin:0;padding:10px 12px;border:1px solid var(--border-strong);border-radius:8px;font-weight:400;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.choice input{flex:none;display:inline-block;width:16px;height:16px;margin:2px 0 0;padding:0;box-shadow:none;accent-color:var(--fg)}
.choice strong{display:block;font-weight:500;overflow-wrap:anywhere}.choice small{display:block;margin-top:2px;color:var(--muted);font-size:12px}
.choice:has(input:checked){border-color:var(--fg);box-shadow:0 0 0 3px var(--ring)}
.error{margin:10px 0 0;font-size:13px;color:var(--bad)}.error:empty{display:none}
.panel{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:56px 24px}
.panel .glyph{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--border);background:var(--subtle);color:var(--muted)}
.panel .glyph svg{width:20px;height:20px}.panel p{margin:0;max-width:280px;color:var(--muted);font-size:14px}
.panel button{margin-top:6px}
</style></head>
<body><header class="top"><div class="brand"><span class="mark" aria-hidden="true"></span>Tommy</div>
<button id="refresh" class="icon" type="button" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button></header>
<main><section id="roster" aria-live="polite"></section></main>
<script nonce="${nonce}">
"use strict";
const words = ${text};
const roster = document.getElementById("roster");
const refresh = document.getElementById("refresh");
const launch = new URLSearchParams(location.hash.slice(1));
const initData = launch.get("tgWebAppData");
// The bot that opened this view. Its own credential signs the launch data.
const bot = new URLSearchParams(location.search).get("bot");
const scope = bot && /^[1-9][0-9]{0,15}$/.test(bot) ? "?bot=" + bot : "";
history.replaceState(null, "", location.pathname);
const base = "/tommy/telegram/app";
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
function postEvent(type, data) {
  const body = JSON.stringify(data || {});
  if (window.TelegramWebviewProxy) window.TelegramWebviewProxy.postEvent(type, body);
  else if (window.external && typeof window.external.notify === "function") window.external.notify(JSON.stringify({eventType:type, eventData:data || {}}));
  else if (window.parent !== window) window.parent.postMessage(JSON.stringify({eventType:type, eventData:data || {}}), "https://web.telegram.org");
}
function applyTheme() {
  let dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  try {
    const theme = JSON.parse(launch.get("tgWebAppThemeParams") || "{}");
    const match = /^#([0-9a-f]{6})$/i.exec(theme.bg_color || "");
    if (match) {
      const value = parseInt(match[1], 16);
      dark = ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114 < 128;
    }
  } catch {}
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const color = dark ? "#0a0a0a" : "#ffffff";
  postEvent("web_app_set_header_color", {color});
  postEvent("web_app_set_background_color", {color});
}
async function post(action, payload) {
  const response = await fetch(base + "/" + action + scope, {method:"POST", credentials:"omit", cache:"no-store", redirect:"error",
    headers:{"Content-Type":"application/json","Authorization":"tma " + initData}, body:JSON.stringify(payload)});
  if (response.status === 403) throw new Error(words.reopen);
  if (!response.ok) throw new Error(words.failure);
  return response;
}
function avatar(name) {
  let hash = 0;
  for (const letter of name) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  const node = element("span", Array.from(name.trim())[0] ? Array.from(name.trim())[0].toUpperCase() : "?", "avatar");
  node.style.background = "linear-gradient(135deg,hsl(" + hue + " 70% 55%),hsl(" + ((hue + 50) % 360) + " 75% 45%))";
  node.setAttribute("aria-hidden", "true");
  return node;
}
function host(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}
function originPill(origin) {
  const pill = element("span", host(origin), "origin");
  pill.title = origin;
  return pill;
}
function field(form, title, type, limit) {
  const label = element("label", title);
  const input = element("input");
  input.type = type;
  input.maxLength = limit;
  input.autocomplete = "off";
  input.required = true;
  label.append(input);
  form.append(label);
  return input;
}
function requestForm(request) {
  const form = element("form", undefined, "block");
  const title = request.method === "password" ? words.password : request.method === "authenticator" ? words.authenticator : words.otp;
  form.append(element("p", title, "title"), originPill(request.origin), element("p", words.privacy, "note"));
  let username;
  if (request.askUsername) {
    username = field(form, words.username, "text", 512);
    username.value = request.username;
  }
  const isCode = request.method !== "password";
  const secret = field(form, isCode ? words.codeField.replace("{digits}", String(request.digits)) : words.passwordField, "password", isCode ? request.digits : 4096);
  if (isCode) {
    secret.type = "text";
    secret.autocomplete = "one-time-code";
    secret.inputMode = "numeric";
    secret.pattern = "[0-9]{" + request.digits + "}";
  }
  const failure = element("p", "", "error");
  failure.setAttribute("role", "alert");
  const actions = element("div", undefined, "actions");
  const submit = element("button", words.confirm, "primary");
  submit.type = "submit";
  const cancel = element("button", words.cancel);
  cancel.type = "button";
  async function answer(decision) {
    if (submit.disabled) return;
    failure.textContent = "";
    submit.disabled = cancel.disabled = true;
    if (decision === "submit") submit.textContent = words.submitting;
    const payload = {handle:request.handle, decision};
    if (decision === "submit") {
      payload.secret = secret.value;
      if (username) payload.username = username.value;
    }
    secret.value = "";
    try {
      await post("secret", payload);
      form.remove();
      await load();
    } catch (error) {
      if (error.message === words.reopen) showPanel("expired");
      else failure.textContent = words.failure;
    } finally {
      submit.disabled = cancel.disabled = false;
      submit.textContent = words.confirm;
    }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void answer("submit"); });
  cancel.addEventListener("click", () => void answer("cancel"));
  actions.append(cancel, submit);
  form.append(failure, actions);
  return form;
}
/** A prompt that needs private input: a secret answer, or a Vault or API key form. */
function signInCard(item) {
  const block = element("div", undefined, "block");
  block.append(element("p", item.name, "title"), originPill(item.origin));
  const button = element("button", words.mcpConnect, "primary");
  button.type = "button";
  const actions = element("div", undefined, "actions");
  const failure = element("p", "", "error");
  failure.setAttribute("role", "alert");
  actions.append(button);
  button.addEventListener("click", async () => {
    button.disabled = true;
    failure.textContent = "";
    try {
      const { url } = await (await post("mcp", { handle: item.handle })).json();
      if (!url) {
        block.replaceChildren(element("p", words.mcpReturn, "note"));
        return;
      }
      const destination = new URL(url);
      if (destination.protocol !== "https:" || destination.username || destination.password) throw new Error(words.failure);
      const link = element("a", words.mcpOpen + " (" + destination.hostname + ")");
      link.href = destination.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (event) => {
        if (window.TelegramWebviewProxy || (window.external && typeof window.external.notify === "function") || window.parent !== window) {
          event.preventDefault();
          postEvent("web_app_open_link", { url: destination.href });
        }
      });
      actions.replaceChildren(link);
    } catch (error) {
      if (error.message === words.reopen) showPanel("expired");
      else failure.textContent = words.failure;
      button.disabled = false;
    }
  });
  block.append(actions, failure);
  return block;
}
function promptForm(prompt) {
  const form = element("form", undefined, "block");
  const title = prompt.form === "vault" ? words.vaultTitle : prompt.form === "api-key" ? words.apiKeyTitle : words.promptTitle;
  form.append(element("p", title, "title"), element("p", words.privacy, "note"));
  const fields = [];
  for (const question of prompt.questions) {
    const group = element("div", undefined, "question");
    if (question.header) group.append(element("span", question.header, "kind-label"));
    if (question.options && question.options.length) {
      group.append(element("p", question.question, "ask"));
      const list = element("div", undefined, "choices");
      for (const option of question.options) {
        const choice = element("label", undefined, "choice");
        const input = element("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = "q-" + question.id;
        input.value = option.label;
        const text = element("span");
        text.append(element("strong", option.label));
        if (option.description) text.append(element("small", option.description));
        choice.append(input, text);
        list.append(choice);
      }
      group.append(list);
      fields.push({ id: question.id, read: () => Array.from(list.querySelectorAll("input:checked"), (input) => input.value), clear: () => {} });
    } else {
      const label = element("label", question.question);
      const input = element("input");
      input.type = question.isSecret ? "password" : "text";
      input.autocomplete = "off";
      input.maxLength = 4096;
      label.append(input);
      group.append(label);
      fields.push({ id: question.id, read: () => (input.value ? [input.value] : []), clear: () => { input.value = ""; } });
    }
    form.append(group);
  }
  const failure = element("p", "", "error");
  failure.setAttribute("role", "alert");
  const actions = element("div", undefined, "actions");
  const submit = element("button", words.confirm, "primary");
  submit.type = "submit";
  const skip = element("button", words.skip);
  skip.type = "button";
  async function answer(decision) {
    if (submit.disabled) return;
    failure.textContent = "";
    submit.disabled = skip.disabled = true;
    if (decision === "submit") submit.textContent = words.submitting;
    const answers = {};
    if (decision === "submit") for (const field of fields) { const values = field.read(); if (values.length) answers[field.id] = values; }
    for (const field of fields) field.clear();
    try {
      await post("answer", { handle: prompt.handle, decision, answers });
      form.remove();
      await load();
    } catch (error) {
      if (error.message === words.reopen) showPanel("expired");
      else failure.textContent = words.failure;
    } finally {
      submit.disabled = skip.disabled = false;
      submit.textContent = words.confirm;
    }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void answer("submit"); });
  skip.addEventListener("click", () => void answer("skip"));
  actions.append(skip, submit);
  form.append(failure, actions);
  return form;
}
let frameEpoch = 0;
function clearFrames() {
  frameEpoch++;
  for (const image of roster.querySelectorAll(".shot img")) { image.hidden = true; image.removeAttribute("src"); }
  for (const frame of roster.querySelectorAll(".shot")) { frame.hidden = true; frame.classList.remove("loading"); }
}
function previewCard(preview) {
  const block = element("div", undefined, "block");
  const top = element("div", undefined, "row");
  const button = element("button", words.viewSnapshot, "small");
  button.type = "button";
  top.append(originPill(preview.origin), button);
  const failure = element("p", "", "error");
  const frame = element("figure", undefined, "shot");
  frame.hidden = true;
  const image = element("img");
  image.alt = preview.origin;
  image.hidden = true;
  frame.append(image);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const generation = frameEpoch;
    button.disabled = true;
    image.hidden = true;
    image.removeAttribute("src");
    frame.hidden = false;
    frame.classList.add("loading");
    failure.textContent = "";
    try {
      const response = await post("preview", {handle: preview.handle});
      const bytes = await response.blob();
      if (!block.isConnected || document.hidden || frameEpoch !== generation) return;
      const url = URL.createObjectURL(bytes);
      image.onload = image.onerror = () => URL.revokeObjectURL(url);
      image.src = url;
      image.hidden = false;
      frame.classList.remove("loading");
      button.textContent = words.refreshSnapshot;
    } catch (error) {
      frame.hidden = true;
      frame.classList.remove("loading");
      if (error.message === words.reopen) showPanel("expired");
      else failure.textContent = words.snapshotUnavailable;
    } finally { button.disabled = false; }
  });
  block.append(top, failure, frame);
  return block;
}
const glyphs = {
  expired: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20c.7-3.4 3-5.5 6-5.5s5.3 2.1 6 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.8c1.7.8 2.7 2.6 3 5.2"/></svg>',
};
function showPanel(kind) {
  const panel = element("div", undefined, "panel");
  const glyph = element("span", undefined, "glyph");
  glyph.innerHTML = glyphs[kind];
  panel.append(glyph, element("p", kind === "expired" ? words.reopen : kind === "error" ? words.failure : words.empty));
  if (kind === "error") {
    const again = element("button", words.retry);
    again.type = "button";
    again.addEventListener("click", () => { placeholders(); void load(); });
    panel.append(again);
  }
  roster.replaceChildren(panel);
  refresh.hidden = kind === "expired";
}
function placeholders() {
  const rows = document.createDocumentFragment();
  rows.append(element("p", words.agents, "label"));
  for (let index = 0; index < 2; index++) rows.append(element("div", undefined, "ghost shimmer"));
  roster.replaceChildren(rows);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) clearFrames(); });
async function load() {
  refresh.disabled = true;
  try {
    if (!initData) throw new Error(words.reopen);
    const state = await (await post("state", {})).json();
    const rows = document.createDocumentFragment();
    rows.append(element("p", words.agents, "label"));
    const prompts = state.prompts || [];
    const signIns = state.signIns || [];
    if (!state.agents.length && !prompts.length && !signIns.length) return showPanel("empty");
    // An agent without its own chat can still ask in work that the owner started here.
    const listed = new Set(state.agents.map((agent) => agent.agentId));
    const others = [];
    for (const prompt of [...prompts, ...signIns])
      if (!listed.has(prompt.agentId) && !others.some((agent) => agent.agentId === prompt.agentId))
        others.push({ agentId: prompt.agentId, name: prompt.agentName || "Tommy", username: "", active: true });
    for (const agent of [...state.agents, ...others]) {
      const card = element("article", undefined, "card");
      const head = element("div", undefined, "head");
      const who = element("div", undefined, "who");
      who.append(element("div", agent.name, "name"));
      if (/^[A-Za-z0-9_]{5,32}$/.test(agent.username)) {
        const link = element("a", "@" + agent.username, "handle");
        link.href = "https://t.me/" + agent.username;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        who.append(link);
      }
      head.append(avatar(agent.name), who, element("span", agent.active ? words.ready : words.pending, agent.active ? "badge ok" : "badge"));
      card.append(head);
      for (const item of signIns) if (agent.agentId === item.agentId) card.append(signInCard(item));
      for (const req of state.requests) if (agent.agentId === req.agentId) card.append(requestForm(req));
      for (const prompt of prompts) if (agent.agentId === prompt.agentId) card.append(promptForm(prompt));
      for (const preview of state.previews) if (agent.agentId === preview.agentId) card.append(previewCard(preview));
      rows.append(card);
    }
    roster.replaceChildren(rows);
  } catch (error) {
    showPanel(error.message === words.reopen ? "expired" : "error");
  } finally {
    refresh.disabled = false;
  }
}
refresh.setAttribute("aria-label", words.retry);
refresh.title = words.retry;
refresh.hidden = !initData;
refresh.addEventListener("click", () => void load());
window.addEventListener("pagehide", () => roster.replaceChildren());
applyTheme();
postEvent("web_app_ready");
postEvent("web_app_expand");
if (initData) placeholders();
void load();
</script></body></html>`;
}
