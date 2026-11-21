# Agent browser

## Browser tool execution

[BrowserHost](../../src/backend/browser-host.ts) owns tabs, navigation and each tab's operation queue. Provider tool requests go through the [browser tool definitions](../../src/backend/browser-tools.ts). The host checks the calling agent and thread before acting. Element references come from a snapshot of the page. Navigation makes references to the previous page invalid.

Browser profiles and persistent sessions stay on the host. Closing the view in Telegram does not close the agent's tabs. The Electron browser window is sandboxed. Its content has no application preload and cannot call server APIs as the owner.

`browser-tools.ts` defines provider schemas and parses each call into a typed tool and its arguments.
`browser-tool-actions.ts` maps input tools to CDP operations. It does not own tabs or import the host.
`BrowserHost` owns tab access checks, operation queues, focus, deadlines, and persistent browser state.
Targeted typing checks that the target still holds focus before the End key, the text, and the
Enter key. A page focus or input handler that moves focus stops it with an error that says if the
text is already in the field. The check also reads each frame element that holds the target,
because a frame in another process can keep its active element after the page takes focus.

Website popups are adopted into managed `WebContentsView` tabs through Electron's window creation
hook. Native guests retain their opener, request body, and the browser session of the opener. Local tab and
agent tool results expose `openerTabId` while that relationship is live. Independent `noopener`
tabs survive parent closure; dependent popups close with the parent. Closing a popup returns to its
opener. Saved popup URLs omit OAuth callback credentials. Popup state is not restored as a live
JavaScript relationship after an app restart.

The host checks live opener groups before permitting secure input, then checks again before dispatch. A page with a conflicting frame in another connected tab may still be able to read its document. A blocked request sends a reason without its authentication URL or request data. The agent inspects new tabs after a login action and gets fresh element references after a document changes.

An agent tab refuses cookie banners (`browser-consent.ts`). On `dom-ready`, the host runs a small
script of its own in an isolated world of the main frame. For up to 15 seconds, it looks for one
visible reject button: the button of a common consent platform, or a button whose whole label
refuses optional cookies ("Reject all", "Only necessary", and the same in some other languages)
inside a dialog, a fixed or sticky box, or a consent container that shows the word "cookie". Text
such as "consent" alone does not count, because sign-in and terms dialogs show it too. It also
looks in open shadow roots, because some platforms build the banner from web components. It clicks
that button once and stops. It never accepts, so a banner with no reject button stays.

A secure-input request stops consent handling on that document. The site stores the refusal in its browser profile. The handler checks the main frame and open shadow roots.

### Fill inspected ordinary fields

`tommy_browser.fill_fields` is a deferred tool in the original browser catalog. It replaces
1 to 16 main-frame native text inputs or textareas from one fresh snapshot revision. The combined
literal text has a 16 KiB UTF-8 limit. The total operation deadline, including its final capture,
is at most 30 seconds. It performs no submit, Enter, click, navigation, target search, or caller
script. Existing individual controls keep their behavior. Its control event uses the released
`type` action.

The engine retains the exact native handles for every field in one CDP lease. Preflight resolves
and checks the full set before any input. It refuses duplicate or unavailable refs, hidden,
disabled or readonly fields, contenteditable, frames, password inputs, one-time-code autocomplete,
and payment-card autocomplete. It accepts native input types `text`, `search`, `tel`, `url`, and
`email`, plus textarea. HTML metadata is not a complete detector for secrets or form side effects.

Authentication fields use the private input flow. An action that needs a person's decision stops and reports the request in Telegram.

Each fill rechecks the same native handle, snapshot fingerprint, original field value, editable
metadata, main-frame document and origin. It does not find a replacement for a changed target.
The native navigation generation and document node identity detect same-URL reloads. Focus handlers
receive a second check before trusted input. The host rechecks tab ownership and secret protection before each field and before it releases a final capture. CDP emulates page focus;
the operation requests no native window or application focus.

One tab queue slot owns all fields, one final page settle, and one bounded final semantic snapshot. Successful input is
confirmed by its native field value. The result contains zero-based `confirmed` indices,
`failedIndex`, and `uncertainIndex`, without field text or page exceptions in the progress record.
`partial` means earlier fields can remain changed. An input sent without confirmed completion is
uncertain. `inputCompleted: true` with `status: snapshot_failed` means input completed but capture
failed. Callers must read the page before they decide how to continue. No automatic retry, undo,
or atomic transaction is promised.

Cancellation prevents undispatched fields. Dispatched input and its confirmation drain before the
queue slot ends. A response deadline can return sooner, but later tab operations still wait for
that owned work. An external debugger that the host cannot cancel must drain its command. The
engine releases retained handles and its lease at completion. Known failures use fixed reason
codes; page exceptions do not enter the new progress result or diagnostic action.

### Run many steps in one call

Each single action tool takes one model turn, and the model reads the page with a separate snapshot.
`tommy_browser.run_script` does many actions in one call and returns one final snapshot, so a long
task takes fewer turns.

`run_script` takes JavaScript that awaits helpers named after the action tools (`navigate`, `click`,
`type`, `press`, `hover`, `scroll`, `selectOption`, `setChecked`, `waitFor`, `evaluate`, and
`snapshot`), or `step({ action, ...fields })` with the fields of that tool and no `tabId`. Each
helper sends one step to the host. The script returns a JSON value of at most 64 KB.

The script sends each step through the corresponding tool's input checks and queue. Failure preserves the effects of completed steps. The result can contain the final URL, value, log and a separate snapshot error. Inspect the page before deciding which actions are safe to repeat.

The script runs in a QuickJS WebAssembly sandbox (`src/backend/browser-script.ts`), not in
`node:vm`, because the backend process holds the vault. The sandbox has no modules, network, files,
timers, or process. Its limits are 64 MiB of memory, a 1 MiB stack, 200 steps, and a total deadline
of `timeoutMs` (default 60 seconds, at most 120 seconds). An interrupt handler stops a script that
loops without steps. Each script gets its own runtime, which the host disposes at the end. The
backend bundle keeps the QuickJS packages external, so the WebAssembly file loads from
`node_modules`.

### Browser sessions

Each agent has one **browser profile**: the persistent partition that its new tabs open in. The agent
fields `ownBrowserSession` and `browserProfileId` (`agent_json`) select it:

| Choice | Partition |
| --- | --- |
| Shared (default) | `persist:tommy-browser` |
| Only this agent | `persist:tommy-browser-agent-<key>`. The key is the first 32 hex characters of the SHA-256 of the agent id. |
| Named profile | `persist:tommy-browser-profile-<id>`. The id is 32 random hex characters. |

Named profiles are rows of the `browser_profiles` table (migration 45). Many agents can use one
profile, so they share its sign-ins; a profile has no owner agent, and the tab rules below do not
change. The name is a label only and never becomes a path or a partition, so a rename keeps the
data. An agent with `browserProfileId` also has `ownBrowserSession: true`. After a downgrade, an
older build thus opens such an agent in a session of its own, never in the shared one.

A tab keeps its partition for its life, and its popups use the same partition. The state file
saves an agent key as `agentSession`, and a named profile as `profile` together with an
`agentSession` key made from the profile id, which an older build reads. A restart restores each tab
in its saved partition, whatever the setting is now. A tab without a key, such as a tab from an older
version, opens in the shared partition. A tab with a malformed key or profile id, or with the id of a
deleted profile, is dropped, so it never opens signed in to another account. A new tab for an agent
whose profile no longer exists fails with `browserProfileMissing`; it never falls back to Shared.
`#configureSession` applies the same user agent, headers, permissions and download policy to every
partition. Shutdown flushes persistent session storage.

### Tab lifetime

The tab owner is its agent and thread. A turn completing, failing or being interrupted leaves its tabs available to the next turn. `close_tab` releases a tab when the task is done. Idle tabs can unload after 30 minutes, or 5 minutes under memory pressure. The URL and partition remain available to restore them on demand. A restart restores saved tabs with their recorded session identifiers. Each tab ID names one lifetime.

### Page dialogs

A watched agent input can open an alert or confirmation dialog. The browser engine listens during the action and its page settle. It returns an opaque dialog ID and a redacted message. A script stops with status `dialog`. The agent can use `handle_dialog` to answer. Further tab actions wait or refuse the open dialog. The tab can still be closed. A dialog created outside the watched action is never attributed to that turn.

Electron also creates a native dialog. When the engine owns the debugger it uses the CDP answer, then cancels the matching native box. After a turn ends its dialog handle expires. A site that requires a person to interact directly can be reported to the originating Telegram chat.

## Screenshots

The owner can use `/browser` in the manager chat or an agent's chat to open the Mini App and request a current screenshot. An ordinary request for manual interaction can deliver a single screenshot to the conversation that started the turn, including a turn delegated to a different agent. The host checks the owner, chat binding, current tab and capture permission. The image allows the owner to inspect the page. Telegram does not send clicks or keys to it.

## Secure browser authentication

A password or one-time code uses the private Mini App form. The host verifies Telegram launch data and matches the pending request to its owner and page. The value goes to the browser through the protected input path. Secret entry blocks capture of sensitive page content. A card fill requires the applicable Vault permission or explicit owner approval.

Cancel, expiry, tab replacement or a changed chat binding can invalidate the request. An agent must report a sign-in that requires unsupported direct interaction. It must never ask the owner to send credentials in chat.

The [Mini App handler](../../src/main/telegram-mini-app.ts) owns the HTTP boundary. [Computer Use](computer-use.md) runs on a separate agent display.

The host serializes entry behind prior tab work and resolves the fields before consent. It rechecks the document and origin just before sending input. While a document might hold a secret, capture, evaluation, recording and page diagnostics are restricted. Same-document navigation alone cannot clear those restrictions.

After a completed submit, the host waits up to five seconds for a new document. If the same document remains, the host clears the filled values and checks the page and its open shadow roots for the secret. A clean result permits the next step of a single-page sign-in while keeping evaluation and recording restricted. Otherwise, a GET reload replaces the document without replaying the form. If that reload fails, the host tries a blank page. When no replacement succeeds the document stays protected. A failed fill reports its reason and requires a new answer before retry.

Run `bun scripts/browser-secure-login-e2e.ts` for the hidden Electron fixture. It writes `.tommy-build/browser-secure-login-e2e/report.json`.

An agent script marks the document and any reachable opener or popup document. A saved-login or
card fill waits until those scripted documents navigate or close. The host also clears the site's
Cache Storage and service workers before a fill. A document served by an old service worker must
reload. Cookies, local storage and IndexedDB stay intact. A failed purge refuses the fill. This is
a fill safety boundary, not a way to make arbitrary agent scripts safe.

Browser scripts keep at most 1 MiB of internal result data. Model-facing results stay bounded to
64 KiB. Large snapshots omit hidden branches before spending the visible element budget. A chat
owns its tab limit; restoring tabs applies that limit without taking focus.

The first Vault card fill displays the amount the agent read, the selected card, the site and any payment-frame origins. A saved approval remains scoped to that card and site. A 1Password card's site approval lasts only for this process. For each 1Password fill, the host fetches the number and security code again for the page. A service account token accessible to an agent's shell grants that shell the token's own permissions.
