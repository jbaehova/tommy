/** Escapes text for an element or a quoted attribute. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RemoteMcpPageText {
  title: string;
  body: string;
  /** Present for the code form. */
  form?: {
    request: string;
    client: string;
    clientLabel: string;
    codeLabel: string;
    approve: string;
    deny: string;
    error: string | null;
  };
}

/** The sign-in page of the remote MCP endpoint. No script runs on it; the form posts to this server. */
export function remoteMcpPage(nonce: string, locale: string, text: RemoteMcpPageText): string {
  const form = text.form
    ? `<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="request" value="${escapeHtml(text.form.request)}">
<p class="client">${escapeHtml(text.form.clientLabel)} <span class="origin">${escapeHtml(text.form.client)}</span></p>
<label for="code">${escapeHtml(text.form.codeLabel)}</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]{8,9}" maxlength="9" autocomplete="one-time-code" autofocus>
${text.form.error ? `<p class="error" role="alert">${escapeHtml(text.form.error)}</p>` : ""}
<div class="actions"><button type="submit" name="decision" value="deny">${escapeHtml(text.form.deny)}</button>
<button class="primary" type="submit" name="decision" value="approve">${escapeHtml(text.form.approve)}</button></div>
</form>`
    : "";
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Tommy</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#0a0a0a;--muted:#6b6b6b;--subtle:#fafafa;--border:#eaeaea;--strong:#d4d4d4;--ring:rgba(10,10,10,.12);--bad:#e5484d;
--sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#a1a1a1;--subtle:#111;--border:#262626;--strong:#3a3a3a;--ring:rgba(237,237,237,.16);--bad:#ff6369;color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:420px;margin:0 auto;padding:48px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:28px}
.mark{width:22px;height:22px;border-radius:6px;background:var(--fg);display:grid;place-items:center}
.mark::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--bg)}
h1{font-size:20px;letter-spacing:-.01em;margin:0 0 8px}p{margin:0 0 12px;color:var(--muted)}
.origin{font:13px var(--mono);color:var(--fg);overflow-wrap:anywhere}
label{display:block;margin-top:20px;font-size:13px;font-weight:500}
input{display:block;width:100%;height:48px;margin-top:6px;padding:0 12px;font:20px var(--mono);letter-spacing:.25em;color:var(--fg);
background:var(--bg);border:1px solid var(--strong);border-radius:8px;outline:none}
input:focus{border-color:var(--fg);box-shadow:0 0 0 3px var(--ring)}
.error{margin-top:10px;color:var(--bad);font-size:13px}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:20px}
button{font:500 15px var(--sans);height:44px;border-radius:8px;cursor:pointer;border:1px solid var(--strong);background:var(--bg);color:var(--fg)}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
</style></head><body><main>
<div class="brand"><span class="mark" aria-hidden="true"></span>Tommy</div>
<h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.body)}</p>${form}
</main></body></html>`;
}
